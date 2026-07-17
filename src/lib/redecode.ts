import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import type { SlackAttachment } from "@/lib/slack/format";
import { parseWebhookPayload, isBroadcastMedium } from "@/lib/meltwater/parse";
import { looksLikePerson } from "@/lib/meltwater/outlets";
import { resolveBrief } from "@/lib/filter/engine";
import { buildStoryAttachment, attachmentHash, broadcastMediumLabel, sameText } from "@/lib/slack/format";
import { updateSlack } from "@/lib/slack/post";
import { resolveStationName } from "@/lib/meltwater/station-resolve";
import { StoryStore, type Outlet, type StoryRow } from "@/lib/story";
import { feedConfig } from "@/config/feed.config";

export interface RedecodeChange {
  ts: string;
  from: string; // headline outlet before the re-decode
  to: string; // headline outlet after
}

export interface RedecodeResult {
  windowHours: number;
  dryRun: boolean;
  scanned: number; // stories updated within the window
  changed: number; // cards whose re-render differs under the current decoding
  updated: number; // chat.update calls that succeeded (0 when dryRun)
  failed: number; // chat.update calls that failed
  unchanged: number; // re-render identical → left untouched
  skipped: number; // no re-parseable raw payload in the snapshot
  remaining: number; // changed cards left unsent because the per-call cap was hit — re-run to finish
  changes: RedecodeChange[]; // headline before→after (capped)
}

const MAX_CHANGES_REPORTED = 200;
// Cap chat.update calls per invocation to stay under Cloudflare's per-request subrequest limit. Excess
// changed cards are reported as `remaining`; re-run (it's idempotent) until `remaining` is 0.
const MAX_UPDATES_PER_CALL = 40;

/**
 * Pure: reparse a story's embedded webhook doc (`raw`) under the CURRENT parser, so re-decoding picks
 * up today's outlet mapping. Broadcast station resolution needs D1, so it's applied separately by the
 * orchestrator via {@link resolveBroadcast}. Returns `reparsed: null` when there's no re-parseable raw.
 */
export function reparseStory(row: StoryRow): { oldPrimary: NormalizedMention; reparsed: NormalizedMention | null } {
  const oldPrimary = JSON.parse(row.primary_mention_json) as NormalizedMention;
  const reparsed = oldPrimary.raw != null ? (parseWebhookPayload(oldPrimary.raw)[0] ?? null) : null;
  return { oldPrimary, reparsed };
}

/**
 * Pure: given a broadcast station name resolved from D1 (or null), decide the headline. Mirrors
 * ingestion (`process.ts:resolveBroadcastOutlet`) so a re-rendered card matches what a fresh one
 * would be:
 *   1. A station named in D1 wins — it becomes the header, the reporter drops to the byline.
 *   2. Else a station-like header (authorName-trust) is itself the station — keep it.
 *   3. Else never regress a card that already showed a real (non-person) station back to the reporter.
 *   4. Else it's a presenter's name with no known station → safety net: neutral masthead, byline.
 */
export function resolveBroadcast(
  reparsed: NormalizedMention,
  oldPrimary: NormalizedMention,
  station: string | null,
): NormalizedMention {
  if (station) {
    const demote = reparsed.sourceName && reparsed.sourceName.toLowerCase() !== station.toLowerCase();
    return { ...reparsed, sourceName: station, author: reparsed.author ?? (demote ? reparsed.sourceName : null) };
  }
  if (reparsed.sourceName && !looksLikePerson(reparsed.sourceName)) return reparsed;
  if (
    oldPrimary.sourceName &&
    !looksLikePerson(oldPrimary.sourceName) &&
    !sameText(oldPrimary.sourceName, reparsed.sourceName ?? "")
  ) {
    return { ...reparsed, sourceName: oldPrimary.sourceName, author: oldPrimary.author ?? reparsed.sourceName, outletUrl: oldPrimary.outletUrl };
  }
  return { ...reparsed, author: reparsed.author ?? reparsed.sourceName, sourceName: broadcastMediumLabel(reparsed.mediaType) };
}

/**
 * Pure: rebuild the card + its hash for a resolved primary. Comparing the hash to the story's stored
 * `render_hash` (the card as last sent to Slack) is what detects a change — this catches both parse-
 * level changes and format changes (e.g. the "also mentions" fix) that a snapshot diff would miss.
 */
export function renderStoryCard(row: StoryRow, primary: NormalizedMention): { attachment: SlackAttachment; hash: string } {
  const outlets = JSON.parse(row.outlets_json) as Outlet[];
  const briefLabels = JSON.parse(row.brief_labels_json || "[]") as string[];
  const attachment = buildStoryAttachment(primary, resolveBrief(primary, feedConfig), outlets, briefLabels.slice(1), row.created_at);
  return { attachment, hash: attachmentHash(attachment) };
}

/**
 * Re-render the cards of stories touched within the last `hours` under the current parser + outlets +
 * format, and chat.update in place any whose rendering changed. Non-destructive: edits existing
 * messages, never deletes/reposts, so reactions/threads survive. Broadcast headers are re-resolved from
 * the D1 station map (no browser here — that runs at ingestion), so a station named since the card was
 * posted is upgraded from the reporter byline. `dryRun` reports what would change without calling Slack.
 * Bounded by recency (idx_stories_updated_at) and by {@link MAX_UPDATES_PER_CALL} per call. `now` is
 * passed in (route uses Date.now()) to keep this deterministic.
 */
export async function redecodeRecentStories(
  env: Env,
  opts: { hours: number; dryRun: boolean; now: number },
): Promise<RedecodeResult> {
  const stories = new StoryStore(env.DB);
  const sinceMs = opts.now - opts.hours * 60 * 60 * 1000;
  const rows = await stories.updatedSince(sinceMs);
  const res: RedecodeResult = {
    windowHours: opts.hours,
    dryRun: opts.dryRun,
    scanned: rows.length,
    changed: 0,
    updated: 0,
    failed: 0,
    unchanged: 0,
    skipped: 0,
    remaining: 0,
    changes: [],
  };

  for (const row of rows) {
    const { oldPrimary, reparsed } = reparseStory(row);
    if (!reparsed) {
      res.skipped++;
      continue;
    }
    const primary = isBroadcastMedium(reparsed.mediaType)
      ? resolveBroadcast(reparsed, oldPrimary, await resolveStationName(env, reparsed.raw))
      : reparsed;
    const { attachment, hash } = renderStoryCard(row, primary);
    if (row.render_hash === hash) {
      res.unchanged++;
      continue;
    }
    res.changed++;
    if (res.changes.length < MAX_CHANGES_REPORTED) {
      res.changes.push({ ts: row.slack_ts, from: oldPrimary.sourceName ?? "", to: primary.sourceName ?? "" });
    }
    if (opts.dryRun) continue;
    // Per-call cap: once we've made enough Slack calls this request, leave the rest for a re-run rather
    // than risk hitting the subrequest limit mid-flight. `failed` attempts count too (they still fetch).
    if (res.updated + res.failed >= MAX_UPDATES_PER_CALL) {
      res.remaining++;
      continue;
    }

    const upd = await updateSlack(env, { channel: row.channel, ts: row.slack_ts, attachments: [attachment] });
    if (upd.ok) {
      // Persist the corrected snapshot + new render hash so later syndication merges keep the fix
      // (rather than reviving the stale decoding from primary_mention_json) and re-runs stay idempotent.
      await stories.updateRenderState(row.story_key, primary, hash);
      res.updated++;
    } else {
      res.failed++;
    }
  }
  return res;
}
