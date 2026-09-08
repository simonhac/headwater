import { sha256Hex } from "@/lib/ids";
import type { NormalizedMention } from "@/lib/meltwater/types";

export interface Outlet {
  name: string; // = the mention's sourceName (the masthead); kept as the dedupe/display key
  url: string | null;
  reach: number | null;
  // Optional display fields — present only on outlets written by the reach-led code (an old
  // `{name,url,reach}` row parses fine with these `undefined`). They let the highest-reach outlet lead
  // the card with its OWN headline/snippet/byline. `raw` is deliberately NOT stored (only the anchor,
  // in `primary_mention_json`, is ever reparsed).
  title?: string | null;
  snippet?: string | null;
  author?: string | null;
  outletUrl?: string | null;
  mediaType?: string | null;
  sentiment?: string | null;
  publishedAt?: string | null;
  matchedKeywords?: string[];
}

export interface StoryRow {
  story_key: string;
  slack_ts: string;
  channel: string;
  brief_label: string | null;
  primary_mention_json: string;
  outlets_json: string;
  /** Every Organisation Brief that matched this story, primary first (JSON string[]). */
  brief_labels_json: string;
  /** Decimal string of the transcript's 64-bit SimHash (null for non-broadcast / too-short text). */
  simhash: string | null;
  media_type: string | null;
  /** Hash of the rendered card last sent to Slack; lets the redecode backfill skip unchanged cards. */
  render_hash: string | null;
  created_at: number;
  updated_at: number;
}

/** Normalize a headline so verbatim wire republications collapse to one key. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Story identity, scoped to the channel it was posted in: `"<channel>|<sha256(normalized title)>"`.
 * The same headline fanned out to two channels is two stories with two Slack messages — folding them
 * would mean one card living in one channel only. Migration 0010 re-keyed the legacy bare-hash rows. */
/**
 * Identity of a headline within a channel — everything but the posting instance.
 *
 * Kept separate from the full key because the two are asked different questions: this prefix
 * answers "is there a card for this headline?", while the full key identifies ONE card.
 */
export async function storyKeyPrefix(channel: string, title: string): Promise<string> {
  return `${channel}|${await sha256Hex(normalizeTitle(title))}`;
}

/**
 * The primary key of one posted card: `"<channel>|<sha256(title)>|<createdAt>"`.
 *
 * The creation timestamp is what stops a headline that recurs OUTSIDE the syndication window from
 * orphaning its predecessor. Before it, the key was eternal while the merge lookup was windowed, so
 * a repeat >72h later found nothing to merge into, posted a fresh card, and then collided on INSERT
 * — `ON CONFLICT DO UPDATE` silently repointed the row at the new message and cut the old card
 * loose. (That was 16 of the 17 orphans swept on 2026-09-08.) Distinct keys let both rows coexist,
 * so every card keeps a row and stays in the orphan sweep's allow-list.
 *
 * `createdAtMs` must be the event's `received_at`, never `Date.now()`, so a replay recomputes the
 * SAME key and re-merges instead of duplicating.
 */
export function storyKeyAt(prefix: string, createdAtMs: number): string {
  return `${prefix}|${createdAtMs}`;
}

/** Build the stored Outlet for a mention, capturing the display fields so a high-reach outlet can lead
 * the card with its own headline/snippet/byline. `raw` is intentionally dropped (only the anchor's
 * `primary_mention_json` is ever reparsed). Shared by ingestion + coalesce so the shape can't diverge. */
export function outletOf(m: NormalizedMention): Outlet {
  return {
    name: m.sourceName ?? "Unknown source",
    url: m.url,
    reach: m.reach,
    title: m.title,
    snippet: m.snippet,
    author: m.author,
    outletUrl: m.outletUrl,
    mediaType: m.mediaType,
    sentiment: m.sentiment,
    publishedAt: m.publishedAt,
    matchedKeywords: m.matchedKeywords,
  };
}

/** Add an outlet to the list unless the same url (or same name) is already present. */
export function addOutlet(outlets: Outlet[], o: Outlet): Outlet[] {
  const dup = outlets.some(
    (x) => (o.url && x.url === o.url) || x.name.toLowerCase() === o.name.toLowerCase(),
  );
  return dup ? outlets : [...outlets, o];
}

/** Add a brief label unless it's already present (case-insensitive); order preserved, primary first. */
export function addBriefLabel(labels: string[], label: string): string[] {
  if (labels.some((l) => l.toLowerCase() === label.toLowerCase())) return labels;
  return [...labels, label];
}

/** Outlets other than the headlined (primary) one — matched by url first, then name (case-insensitive). */
export function otherOutlets(outlets: Outlet[], primary: { sourceName: string | null; url: string | null }): Outlet[] {
  const primName = (primary.sourceName ?? "").toLowerCase();
  return outlets.filter((o) => o.url !== primary.url && o.name.toLowerCase() !== primName);
}

export class StoryStore {
  constructor(private db: D1Database) {}

  /**
   * The newest mergeable card for a headline in a channel, or null. A story is only mergeable if it
   * was updated within the window; an older one is left alone as history rather than overwritten.
   *
   * Matched on the `"<channel>|<hash>"` prefix via a range scan (`|` is 0x7C, `}` is 0x7D), which
   * uses the primary-key index — unlike `LIKE 'prefix%'`, which SQLite only optimises when
   * `case_sensitive_like` is on. The range also spans pre-0011 two-part keys, so a row the
   * migration somehow missed is still found rather than silently duplicated.
   */
  async getFresh(prefix: string, sinceMs: number): Promise<StoryRow | null> {
    return await this.db
      .prepare(
        `SELECT * FROM stories
          WHERE story_key >= ?1 AND story_key < ?2 AND updated_at >= ?3
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(prefix, `${prefix}}`, sinceMs)
      .first<StoryRow>();
  }

  async create(row: {
    key: string;
    slackTs: string;
    channel: string;
    briefLabel: string | null;
    briefLabels: string[];
    primary: unknown;
    outlets: Outlet[];
    simhash: string | null;
    mediaType: string | null;
    renderHash: string | null;
    now: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO stories
           (story_key, slack_ts, channel, brief_label, primary_mention_json, outlets_json,
            brief_labels_json, simhash, media_type, render_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(story_key) DO UPDATE SET
           slack_ts=excluded.slack_ts, channel=excluded.channel, brief_label=excluded.brief_label,
           primary_mention_json=excluded.primary_mention_json, outlets_json=excluded.outlets_json,
           brief_labels_json=excluded.brief_labels_json, simhash=excluded.simhash, media_type=excluded.media_type,
           render_hash=excluded.render_hash, created_at=excluded.created_at, updated_at=excluded.updated_at`,
      )
      .bind(
        row.key,
        row.slackTs,
        row.channel,
        row.briefLabel,
        JSON.stringify(row.primary),
        JSON.stringify(row.outlets),
        JSON.stringify(row.briefLabels),
        row.simhash,
        row.mediaType,
        row.renderHash,
        row.now,
        row.now,
      )
      .run();
  }

  /** Update the outlet list and matched-brief set (and the card's render hash) after folding in a mention. */
  async updateOutlets(key: string, outlets: Outlet[], briefLabels: string[], renderHash: string | null, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE stories SET outlets_json = ?, brief_labels_json = ?, render_hash = ?, updated_at = ? WHERE story_key = ?`)
      .bind(JSON.stringify(outlets), JSON.stringify(briefLabels), renderHash, now, key)
      .run();
  }

  /** Recent stories in ONE channel that carry a SimHash (broadcast), for near-duplicate lookup.
   * Channel-scoped for the same reason as `storyKey`: a near-dup can only fold into a card that
   * lives in the channel we're about to post to. Oldest-first so a tie among equally-good matches
   * folds into the ORIGINAL card (stable under replay/reconcile). */
  async recentWithSimhash(sinceMs: number, channel: string): Promise<StoryRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM stories WHERE simhash IS NOT NULL AND updated_at >= ? AND channel = ? ORDER BY created_at ASC`)
      .bind(sinceMs, channel)
      .all<StoryRow>();
    return res.results ?? [];
  }

  /** Stories touched within the window (oldest-first for stable output); backs the redecode backfill. */
  async updatedSince(sinceMs: number): Promise<StoryRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM stories WHERE updated_at >= ? ORDER BY updated_at ASC`)
      .bind(sinceMs)
      .all<StoryRow>();
    return res.results ?? [];
  }

  /** After a re-decode+chat.update: store the corrected snapshot + new render hash; recency untouched. */
  async updateRenderState(key: string, primary: unknown, renderHash: string): Promise<void> {
    await this.db
      .prepare(`UPDATE stories SET primary_mention_json = ?, render_hash = ? WHERE story_key = ?`)
      .bind(JSON.stringify(primary), renderHash, key)
      .run();
  }

  /** Broadcast stories (carry a SimHash) CREATED within the window — the coalesce backfill's
   * candidate set. Ordered oldest-first so star-clustering anchors on the original card. Note: no
   * `created_at` index exists (only `updated_at`/`simhash`), so this is a bounded full scan — fine
   * for a one-off maintenance sweep. */
  async broadcastStoriesSince(sinceMs: number): Promise<StoryRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM stories WHERE simhash IS NOT NULL AND created_at >= ? ORDER BY created_at ASC`)
      .bind(sinceMs)
      .all<StoryRow>();
    return res.results ?? [];
  }

  /** Delete a story row (used by the coalesce backfill AFTER its duplicate Slack message is removed). */
  async deleteStory(key: string): Promise<void> {
    await this.db.prepare(`DELETE FROM stories WHERE story_key = ?`).bind(key).run();
  }

  /**
   * Rewrite the stored text of a story WITHOUT touching `updated_at` — for data repairs (e.g. the
   * snippet backfill) rather than new activity. Bumping recency here would be actively harmful: it
   * would drag a long-settled story back inside the 72h syndication window and make it a live merge
   * target again. Mirrors `updateRenderState`, which leaves recency alone for the same reason.
   */
  async repairText(key: string, primary: unknown, outlets: Outlet[], renderHash: string | null): Promise<void> {
    await this.db
      .prepare(`UPDATE stories SET primary_mention_json = ?, outlets_json = ?, render_hash = ? WHERE story_key = ?`)
      .bind(JSON.stringify(primary), JSON.stringify(outlets), renderHash, key)
      .run();
  }

  /** Persist a coalesced canonical in one write: the re-resolved primary snapshot, the merged outlet
   * + matched-brief lists, and the new render hash. Recency is bumped so the hourly heal keeps the
   * fix rather than reviving a stale render. Used by the coalesce backfill. */
  async coalesceInto(key: string, primary: unknown, outlets: Outlet[], briefLabels: string[], renderHash: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE stories SET primary_mention_json = ?, outlets_json = ?, brief_labels_json = ?, render_hash = ?, updated_at = ? WHERE story_key = ?`,
      )
      .bind(JSON.stringify(primary), JSON.stringify(outlets), JSON.stringify(briefLabels), renderHash, now, key)
      .run();
  }
}
