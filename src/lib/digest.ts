import type { Env } from "@/env";
import { StoryStore, type Outlet, type StoryRow } from "@/lib/story";
import { renderStoryCard } from "@/lib/redecode";
import { feedConfig, DEFAULT_BRIEF_COLOR } from "@/config/feed.config";
import type { NormalizedMention } from "@/lib/meltwater/types";
import type { SlackAttachment } from "@/lib/slack/format";

/**
 * Building the periodic digest: the set of stories to include, grouped into brief sections and
 * ordered by reach. Pure data — `src/ui/email.ts` turns this into HTML.
 *
 * The card itself is NOT rebuilt here. `renderStoryCard` (src/lib/redecode.ts) is the single place
 * that turns a StoryRow into a SlackAttachment, so the digest tile is byte-identical to the Slack
 * card the story already posted as. New surface, same strings.
 */

/** Display timezone for the digest — the audience is Australian, and the send is pinned to 8am local. */
export const DIGEST_TZ = "Australia/Melbourne";

export interface DigestTile {
  storyKey: string;
  /** The card, exactly as Slack renders it. */
  att: SlackAttachment;
  /** Combined reach across every outlet on the story — the sort key, and what the footer prints. */
  reach: number;
  createdAt: number;
}

export interface DigestSection {
  label: string;
  color: string;
  tiles: DigestTile[];
  /** Sum of member tiles' combined reach — the sort key for sections. */
  totalReach: number;
}

export interface Digest {
  sections: DigestSection[];
  storyCount: number;
  sinceMs: number;
  untilMs: number;
}

/** Combined reach across a story's outlets. Mirrors the merged-outlet footer's "combined reach". */
export function combinedReach(outlets: Outlet[]): number {
  return outlets.reduce((sum, o) => sum + (o.reach && o.reach > 0 ? o.reach : 0), 0);
}

/** Brief colour by label (the digest groups on the stored label, not the BriefRule object). */
export function colorForBriefLabel(label: string): string {
  const brief = feedConfig.briefs.find((b) => b.label.toLowerCase() === label.toLowerCase());
  return brief?.color ?? DEFAULT_BRIEF_COLOR;
}

/**
 * Story identity for the digest: the title hash alone, independent of which Slack channel the story
 * was posted to and of which posting instance it is.
 *
 * `story_key` is `"<channel>|<sha256(normalized title)>|<createdAt>"` (src/lib/story.ts), so ONE
 * headline routed to N channels is N rows, and a headline recurring after the syndication window adds
 * more. `updatedSince` is not channel-scoped, so without this fold the digest would print the same
 * story several times and count its reach several times in the section total. The digest is one
 * email, not one per channel.
 *
 * Takes the MIDDLE component deliberately — the trailing `createdAt` differs per posted card, so
 * keying on the last segment would defeat the fold entirely and could collide two unrelated stories
 * created in the same millisecond. Older shapes (`channel|hash`, and the original bare hash) are
 * handled too, so a digest spanning a migration stays correct.
 */
export function digestIdentity(storyKey: string): string {
  const parts = storyKey.split("|");
  return parts.length >= 2 ? parts[1]! : storyKey;
}

/**
 * Pure: group already-fetched story rows into the digest model.
 *
 * Only stories CREATED in the window are included. `StoryStore.updatedSince` keys off `updated_at`,
 * so it also returns older stories that merely gained an outlet inside the window — those already
 * went out in an earlier digest, and re-listing them would make the same story recur for days.
 * There's no `created_at` index (see story.ts), so the window is applied here rather than in SQL.
 */
export function buildDigestModel(rows: StoryRow[], sinceMs: number, untilMs: number): Digest {
  // Pass 1: one entry per story identity, collapsing the per-channel copies of a fanned-out story.
  // Tie-break is total and deterministic (reach, then oldest, then key) so the digest is stable
  // across reruns regardless of the order D1 hands rows back.
  const best = new Map<string, { tile: DigestTile; label: string }>();

  for (const row of rows) {
    if (row.created_at < sinceMs || row.created_at >= untilMs) continue;

    let primary: NormalizedMention;
    let outlets: Outlet[];
    try {
      primary = JSON.parse(row.primary_mention_json) as NormalizedMention;
      outlets = JSON.parse(row.outlets_json) as Outlet[];
    } catch {
      continue; // an unparseable row must never take the whole digest down
    }

    const labels = safeLabels(row);
    const label = labels[0] ?? feedConfig.defaultBriefLabel;
    const { attachment } = renderStoryCard(row, primary);
    const tile: DigestTile = {
      storyKey: row.story_key,
      att: attachment,
      reach: combinedReach(outlets),
      createdAt: row.created_at,
    };

    const id = digestIdentity(row.story_key);
    const incumbent = best.get(id);
    if (!incumbent || beats(tile, incumbent.tile)) best.set(id, { tile, label });
  }

  // Pass 2: group the survivors into brief sections.
  const byLabel = new Map<string, DigestSection>();
  for (const { tile, label } of best.values()) {
    let section = byLabel.get(label);
    if (!section) {
      section = { label, color: colorForBriefLabel(label), tiles: [], totalReach: 0 };
      byLabel.set(label, section);
    }
    section.tiles.push(tile);
    section.totalReach += tile.reach;
  }

  // Tiles by reach desc (ties → newest first, so the ordering is total and stable).
  for (const section of byLabel.values()) {
    section.tiles.sort((a, b) => b.reach - a.reach || b.createdAt - a.createdAt);
  }
  // Sections by combined reach desc (ties → label, again for stability).
  const sections = [...byLabel.values()].sort(
    (a, b) => b.totalReach - a.totalReach || a.label.localeCompare(b.label),
  );

  return {
    sections,
    storyCount: sections.reduce((n, s) => n + s.tiles.length, 0),
    sinceMs,
    untilMs,
  };
}

/** Which of two copies of the same story leads the digest. Total order, so the result is stable. */
function beats(a: DigestTile, b: DigestTile): boolean {
  if (a.reach !== b.reach) return a.reach > b.reach;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt; // the original, not a later copy
  return a.storyKey < b.storyKey;
}

/** Every brief that matched, primary first; falls back to the legacy single label then the default. */
function safeLabels(row: StoryRow): string[] {
  try {
    const parsed = JSON.parse(row.brief_labels_json || "[]") as string[];
    if (parsed.length) return parsed;
  } catch {
    /* fall through */
  }
  return row.brief_label ? [row.brief_label] : [];
}

/** Fetch + group the stories created in [sinceMs, untilMs). */
export async function buildDigest(env: Env, sinceMs: number, untilMs: number): Promise<Digest> {
  const stories = new StoryStore(env.DB);
  // `updatedSince` is the only recency query available; buildDigestModel narrows to created_at.
  const rows = await stories.updatedSince(sinceMs);
  return buildDigestModel(rows, sinceMs, untilMs);
}
