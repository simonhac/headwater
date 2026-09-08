import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import type { SlackAttachment } from "@/lib/slack/format";
import { parseWebhookPayload, isBroadcastMedium } from "@/lib/meltwater/parse";
import { hostnameOf, looksLikePerson, mastheadForDomain } from "@/lib/meltwater/outlets";
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
  remaining: number; // stories left unfixed because the per-call write cap was hit — re-run to finish
  repaired: number; // stored names fixed without a Slack call (the card renders identically)
  outletsRenamed: number; // stories whose stored outlet names were brought up to date
  changes: RedecodeChange[]; // headline before→after (capped)
  outletRenames: RedecodeChange[]; // stored outlet name before→after (capped)
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
 * Pure: bring a story's stored outlet names up to date with the current masthead table.
 *
 * The anchor in `primary_mention_json` keeps its `raw` and so can simply be reparsed, but the entries
 * in `outlets_json` never stored one — they can't be re-decoded, only re-named. Each does keep the
 * publisher URL it was built from, which is all `mastheadForDomain` needs. This matters because a
 * merged story's card can be led by an outlet rather than the anchor (`buildStoryAttachment`), so a
 * stale name here is a wrong HEADLINE, not just a wrong footer entry.
 *
 * Only ever replaces a name with a mapped masthead: it never derives one from the domain, so an outlet
 * we can't name stays exactly as it is. Entries predating the reach-led code have no `outletUrl` and
 * are skipped (there are none inside redecode's usual windows). Idempotent.
 *
 * BROADCAST IS EXCLUDED. A station name belongs to the station-resolve pipeline, not to this table —
 * abc.net.au maps to the plain "ABC", so remapping a radio entry would demote a resolved
 * "ABC Central Coast NSW" back to "ABC". Same reasoning as {@link resolveBroadcast}'s rule 3 and the
 * broadcast branch of the parser: never regress a specific station to a generic masthead.
 */
export function remapOutletNames(outlets: Outlet[]): { outlets: Outlet[]; renames: { from: string; to: string }[] } {
  const renames: { from: string; to: string }[] = [];
  const next = outlets.map((o) => {
    if (isBroadcastMedium(o.mediaType ?? null)) return o;
    const masthead = mastheadForDomain(hostnameOf(o.outletUrl ?? null));
    if (!masthead || masthead === o.name) return o;
    renames.push({ from: o.name, to: masthead });
    return { ...o, name: masthead };
  });
  return { outlets: renames.length ? next : outlets, renames };
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
export function renderStoryCard(
  row: StoryRow,
  primary: NormalizedMention,
  /** Outlets to render instead of the row's stored ones — used by backfills that rewrite them. */
  outletsOverride?: Outlet[],
): { attachment: SlackAttachment; hash: string } {
  const outlets = outletsOverride ?? (JSON.parse(row.outlets_json) as Outlet[]);
  const briefLabels = JSON.parse(row.brief_labels_json || "[]") as string[];
  const attachment = buildStoryAttachment(primary, resolveBrief(primary, feedConfig), outlets, briefLabels.slice(1), row.created_at);
  return { attachment, hash: attachmentHash(attachment) };
}

/**
 * Re-render the cards of stories touched within the last `hours` under the current parser + outlets +
 * format, and chat.update in place any whose rendering changed. Non-destructive: edits existing
 * messages, never deletes/reposts, so reactions/threads survive. Broadcast headers are re-resolved from
 * the D1 station map (no browser here — that runs at ingestion), so a station named since the card was
 * posted is upgraded from the reporter byline. Stored outlet names are re-mapped too
 * ({@link remapOutletNames}) — the anchor is the only mention that can be reparsed, so without that a
 * merged card led by an outlet would keep a stale masthead in its headline. `dryRun` reports what would
 * change without calling Slack.
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
    repaired: 0,
    outletsRenamed: 0,
    changes: [],
    outletRenames: [],
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
    const { outlets, renames } = remapOutletNames(JSON.parse(row.outlets_json) as Outlet[]);
    const { attachment, hash } = renderStoryCard(row, primary, renames.length ? outlets : undefined);
    const cardChanged = row.render_hash !== hash;
    if (!cardChanged && renames.length === 0) {
      res.unchanged++;
      continue;
    }
    if (renames.length) {
      res.outletsRenamed++;
      for (const r of renames) {
        if (res.outletRenames.length < MAX_CHANGES_REPORTED) res.outletRenames.push({ ts: row.slack_ts, ...r });
      }
    }
    if (cardChanged) {
      res.changed++;
      if (res.changes.length < MAX_CHANGES_REPORTED) {
        res.changes.push({ ts: row.slack_ts, from: oldPrimary.sourceName ?? "", to: primary.sourceName ?? "" });
      }
    }
    if (opts.dryRun) continue;
    // Per-call cap: once we've done enough work this request, leave the rest for a re-run rather than
    // risk hitting the subrequest limit mid-flight. Data-only repairs share the budget (they still
    // write to D1); `failed` attempts count too, since they still fetch.
    if (res.updated + res.failed + res.repaired >= MAX_UPDATES_PER_CALL) {
      res.remaining++;
      continue;
    }

    // Persist the corrected snapshot + names + new render hash so later syndication merges keep the fix
    // (rather than reviving the stale decoding from primary_mention_json) and re-runs stay idempotent.
    // `repairText` leaves `updated_at` alone — this is a repair, not new activity on the story.
    if (!cardChanged) {
      // Renames only reached outlets the card doesn't show (the footer list is capped): fix the stored
      // data, but don't spend a chat.update re-sending an identical card.
      await stories.repairText(row.story_key, primary, outlets, hash);
      res.repaired++;
      continue;
    }

    const upd = await updateSlack(env, { channel: row.channel, ts: row.slack_ts, attachments: [attachment] });
    if (upd.ok) {
      await stories.repairText(row.story_key, primary, outlets, hash);
      res.updated++;
    } else {
      res.failed++;
    }
  }
  return res;
}
