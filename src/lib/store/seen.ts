/** Dedupe / idempotency store: one row per mention we've already handled. */
export class SeenStore {
  constructor(private db: D1Database) {}

  async has(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS x FROM seen_mentions WHERE id = ?`)
      .bind(id)
      .first<{ x: number }>();
    return row != null;
  }

  /** Mark as seen. Idempotent (INSERT OR IGNORE) so retries are safe. */
  async add(id: string, url: string, now: number): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO seen_mentions (id, url, first_seen_at) VALUES (?, ?, ?)`)
      .bind(id, url, now)
      .run();
  }

  async prune(olderThanMs: number): Promise<void> {
    await this.db.prepare(`DELETE FROM seen_mentions WHERE first_seen_at < ?`).bind(olderThanMs).run();
  }
}
