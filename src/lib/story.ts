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
    primary: unknown;
    outlets: Outlet[];
    now: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO stories
           (story_key, slack_ts, channel, brief_label, primary_mention_json, outlets_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(story_key) DO UPDATE SET
           slack_ts=excluded.slack_ts, channel=excluded.channel, brief_label=excluded.brief_label,
           primary_mention_json=excluded.primary_mention_json, outlets_json=excluded.outlets_json,
           created_at=excluded.created_at, updated_at=excluded.updated_at`,
      )
      .bind(
        row.key,
        row.slackTs,
        row.channel,
        row.briefLabel,
        JSON.stringify(row.primary),
        JSON.stringify(row.outlets),
        row.now,
        row.now,
      )
      .run();
  }

  async updateOutlets(key: string, outlets: Outlet[], now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE stories SET outlets_json = ?, updated_at = ? WHERE story_key = ?`)
      .bind(JSON.stringify(outlets), now, key)
      .run();
  }
}
