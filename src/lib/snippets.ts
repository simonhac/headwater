/**
 * Backfill: apply `tidySnippet` to snippets already stored in D1, and update any card whose
 * rendering changes as a result.
 *
 * Distinct from `/admin/redecode`, which re-parses every story under the current parser and only
 * ever rewrites `primary_mention_json`. Two gaps that leaves, both real in production:
 *
 *   1. `outlets_json` carries its own snippet per outlet, and a high-reach outlet leads the card
 *      with ITS text — so a defective snippet stays visible however many times you redecode.
 *   2. Redecode persists nothing when the re-render is identical, so a story whose stale snippet
 *      isn't currently displayed keeps it, ready to surface on a later re-render.
 *
 * So this sweep rewrites both snapshots, and persists the repair even when the card doesn't change.
 * It skips rows with nothing to fix, so it touches only what it must — no station resolution, no
 * re-parsing, and no Slack call for a row whose rendering is unaffected.
 */
import type { Env } from "@/env";
import type { NormalizedMention } from "@/lib/meltwater/types";
import { tidySnippet } from "@/lib/meltwater/parse";
import { renderStoryCard } from "@/lib/redecode";
import { updateSlack } from "@/lib/slack/post";
import { StoryStore, type Outlet, type StoryRow } from "@/lib/story";

export interface SnippetRepairResult {
  windowHours: number;
  dryRun: boolean;
  /** Stories examined (those updated within the window). */
  scanned: number;
  /** Stories whose stored text needed repair. */
  needRepair: number;
  /** Of those, how many changed the rendered card (the rest were data-only fixes). */
  cardChanged: number;
  /** Rows whose stored text was rewritten (0 on a dry run). */
  repaired: number;
  /** Successful `chat.update` calls. */
  updated: number;
  failed: number;
  /** Cards left for a re-run because the per-call Slack cap was hit. */
  remaining: number;
  samples: { ts: string; before: string; after: string }[];
}

const MAX_SAMPLES = 50;
/** Keep both edges of a sample visible: the cleanse changes the head, the tail, or both. */
const SAMPLE_EDGE = 40;

/** Elide the middle, not the end — a tail-only change is invisible under a plain `slice(0, n)`. */
function edges(s: string): string {
  return s.length <= SAMPLE_EDGE * 2 + 5 ? s : `${s.slice(0, SAMPLE_EDGE)} [\u2026] ${s.slice(-SAMPLE_EDGE)}`;
}

/** Mirrors redecode/coalesce: stay well under Cloudflare's subrequest limit; re-run until 0. */
const MAX_UPDATES_PER_CALL = 40;

/** The tidied copy of a story's text, plus whether anything actually changed. */
function tidyStory(row: StoryRow): {
  primary: NormalizedMention;
  outlets: Outlet[];
  changed: boolean;
  before: string;
  after: string;
} {
  const primary = JSON.parse(row.primary_mention_json) as NormalizedMention;
  const outlets = JSON.parse(row.outlets_json) as Outlet[];

  const newPrimarySnippet = tidySnippet(primary.snippet);
  let changed = newPrimarySnippet !== primary.snippet;
  let before = changed ? (primary.snippet ?? "") : "";
  let after = changed ? (newPrimarySnippet ?? "") : "";

  const newOutlets = outlets.map((o) => {
    // `snippet` is optional on Outlet (older rows predate the display fields) — leave those alone
    // rather than writing an explicit null into a row that never had the key.
    if (o.snippet === undefined) return o;
    const tidied = tidySnippet(o.snippet);
    if (tidied === o.snippet) return o;
    changed = true;
    if (!before) {
      before = o.snippet ?? "";
      after = tidied ?? "";
    }
    return { ...o, snippet: tidied };
  });

  return { primary: { ...primary, snippet: newPrimarySnippet }, outlets: newOutlets, changed, before, after };
}

export async function repairSnippets(
  env: Env,
  opts: { hours: number; dryRun: boolean; now: number },
): Promise<SnippetRepairResult> {
  const stories = new StoryStore(env.DB);
  const rows = await stories.updatedSince(opts.now - opts.hours * 60 * 60 * 1000);
  const res: SnippetRepairResult = {
    windowHours: opts.hours,
    dryRun: opts.dryRun,
    scanned: rows.length,
    needRepair: 0,
    cardChanged: 0,
    repaired: 0,
    updated: 0,
    failed: 0,
    remaining: 0,
    samples: [],
  };

  for (const row of rows) {
    const { primary, outlets, changed, before, after } = tidyStory(row);
    if (!changed) continue;
    res.needRepair++;
    if (res.samples.length < MAX_SAMPLES) {
      res.samples.push({ ts: row.slack_ts, before: edges(before), after: edges(after) });
    }

    const { attachment, hash } = renderStoryCard(row, primary, outlets);
    const cardChanges = hash !== row.render_hash;
    if (cardChanges) res.cardChanged++;
    if (opts.dryRun) continue;

    if (!cardChanges) {
      // Data-only repair: the snippet isn't what this card displays, but leaving it stale would let
      // it resurface the next time the story is re-rendered from its snapshot.
      await stories.repairText(row.story_key, primary, outlets, row.render_hash);
      res.repaired++;
      continue;
    }

    if (res.updated + res.failed >= MAX_UPDATES_PER_CALL) {
      res.remaining++;
      continue;
    }
    const upd = await updateSlack(env, { channel: row.channel, ts: row.slack_ts, attachments: [attachment] });
    if (!upd.ok) {
      res.failed++; // leave the row untouched so a re-run retries both the update and the write
      continue;
    }
    // Persist only after Slack confirms, so a failure can't leave D1 claiming a card it never sent.
    await stories.repairText(row.story_key, primary, outlets, hash);
    res.updated++;
    res.repaired++;
  }

  return res;
}
