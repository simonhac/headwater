import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import type { SlackAttachment } from "@/lib/slack/format";
import { parseWebhookPayload, isBroadcastMedium } from "@/lib/meltwater/parse";
import { resolveBrief } from "@/lib/filter/engine";
import { buildAttachment, attachmentHash } from "@/lib/slack/format";
import { updateSlack } from "@/lib/slack/post";
import { StoryStore, otherOutlets, type Outlet, type StoryRow } from "@/lib/story";
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
 * Re-render one story's card under the CURRENT parser + outlets + format, and report whether that
 * differs from what's live in Slack (via the stored `render_hash`). Pure (no Slack/DB) so it's
 * unit-testable. The headlined mention embeds its original webhook doc (`raw`), so we re-parse that
 * to pick up today's outlet decoding; rendering it with today's `buildAttachment` also picks up
 * format changes (e.g. the "also mentions" fix) that leave the mention fields untouched — which a
 * snapshot-vs-snapshot diff would miss. Comparing to `render_hash` (the card as last sent) is what
 * catches both. Secondary outlets carry no raw, so only the headline is re-decoded (they still render
 * in the "Also in:" line). A NULL `render_hash` (row posted before the column existed) counts as
 * changed, so the first backfill refreshes it.
 */
export function redecodeStory(row: StoryRow): {
  skipped: boolean;
  changed: boolean;
  from: string;
  to: string;
  newPrimary: NormalizedMention;
  attachment: SlackAttachment;
  hash: string;
} {
  const oldPrimary = JSON.parse(row.primary_mention_json) as NormalizedMention;
  const outlets = JSON.parse(row.outlets_json) as Outlet[];
  const briefLabels = JSON.parse(row.brief_labels_json || "[]") as string[];
  const render = (p: NormalizedMention): SlackAttachment =>
    buildAttachment(p, resolveBrief(p, feedConfig), otherOutlets(outlets, p), briefLabels.slice(1), row.created_at);

  const reparsed = oldPrimary.raw != null ? (parseWebhookPayload(oldPrimary.raw)[0] ?? null) : null;
  if (!reparsed) {
    const label = oldPrimary.sourceName ?? "";
    return { skipped: true, changed: false, from: label, to: label, newPrimary: oldPrimary, attachment: render(oldPrimary), hash: row.render_hash ?? "" };
  }
  // Broadcast station names come from process.ts's live station-code resolution (network + D1 cache),
  // which a pure re-parse can't reproduce — so keep the stored station header + reporter byline and only
  // re-render body/format changes. Otherwise a resolved station ("4BC 1116 News Talk") would regress to
  // the raw reporter name ("Ben Davis") that the parser falls back to.
  const newPrimary = isBroadcastMedium(reparsed.mediaType)
    ? { ...reparsed, sourceName: oldPrimary.sourceName, author: oldPrimary.author, outletUrl: oldPrimary.outletUrl }
    : reparsed;
  const attachment = render(newPrimary);
  const hash = attachmentHash(attachment);
  return {
    skipped: false,
    changed: row.render_hash !== hash,
    from: oldPrimary.sourceName ?? "",
    to: newPrimary.sourceName ?? "",
    newPrimary,
    attachment,
    hash,
  };
}

/**
 * Re-render the cards of stories touched within the last `hours` under the current parser + outlets
 * table, and chat.update in place any whose rendering changed (e.g. after adding an outlet decoding or
 * fixing snippet formatting). Non-destructive: it edits existing messages, never deletes/reposts, so
 * reactions/threads survive. `dryRun` reports what would change without calling Slack. Bounded by
 * recency (idx_stories_updated_at) so it never walks the whole archive. `now` is passed in (route uses
 * Date.now()) to keep this deterministic and testable.
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
    const r = redecodeStory(row);
    if (r.skipped) {
      res.skipped++;
      continue;
    }
    if (!r.changed) {
      res.unchanged++;
      continue;
    }
    res.changed++;
    if (res.changes.length < MAX_CHANGES_REPORTED) res.changes.push({ ts: row.slack_ts, from: r.from, to: r.to });
    if (opts.dryRun) continue;
    // Per-call cap: once we've made enough Slack calls this request, leave the rest for a re-run rather
    // than risk hitting the subrequest limit mid-flight. `failed` attempts count too (they still fetch).
    if (res.updated + res.failed >= MAX_UPDATES_PER_CALL) {
      res.remaining++;
      continue;
    }

    const upd = await updateSlack(env, { channel: row.channel, ts: row.slack_ts, attachments: [r.attachment] });
    if (upd.ok) {
      // Persist the corrected snapshot + new render hash so later syndication merges keep the fix
      // (rather than reviving the stale decoding from primary_mention_json) and re-runs stay idempotent.
      await stories.updateRenderState(row.story_key, r.newPrimary, r.hash);
      res.updated++;
    } else {
      res.failed++;
    }
  }
  return res;
}
