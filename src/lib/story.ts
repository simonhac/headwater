import { sha256Hex } from "@/lib/ids";

export interface Outlet {
  name: string;
  url: string | null;
  reach: number | null;
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

export async function storyKey(title: string): Promise<string> {
  return sha256Hex(normalizeTitle(title));
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

  /** A story is only mergeable if it was updated within the window (else it's a fresh story). */
  async getFresh(key: string, sinceMs: number): Promise<StoryRow | null> {
    return await this.db
      .prepare(`SELECT * FROM stories WHERE story_key = ? AND updated_at >= ?`)
      .bind(key, sinceMs)
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

  /** Recent stories that carry a SimHash (broadcast), for near-duplicate lookup. Oldest-first so a
   * tie among equally-good matches folds into the ORIGINAL card (stable under replay/reconcile). */
  async recentWithSimhash(sinceMs: number): Promise<StoryRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM stories WHERE simhash IS NOT NULL AND updated_at >= ? ORDER BY created_at ASC`)
      .bind(sinceMs)
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
}
