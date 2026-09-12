/** Tiny key/value store for operational state that outlives a single request (e.g. the ingestion
 * heartbeat's alert bookkeeping). Backed by the `ops_state` table (migration 0005). */
export class OpsState {
  constructor(private db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare(`SELECT value FROM ops_state WHERE key = ?`).bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  /** Convenience for epoch-ms / numeric values; null when absent or unparseable. */
  async getNumber(key: string): Promise<number | null> {
    const v = await this.get(key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Several numeric keys in one round trip — /health reads both cron markers on every poll and
   *  should not pay a query each. Missing keys are simply absent from the map. */
  async getNumbers(keys: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (keys.length === 0) return out;
    const placeholders = keys.map(() => "?").join(", ");
    const res = await this.db
      .prepare(`SELECT key, value FROM ops_state WHERE key IN (${placeholders})`)
      .bind(...keys)
      .all<{ key: string; value: string }>();
    for (const r of res.results ?? []) {
      const n = Number(r.value);
      if (Number.isFinite(n)) out.set(r.key, n);
    }
    return out;
  }

  /** Upsert. `now` is the caller's clock (epoch ms), stored as updated_at. */
  async set(key: string, value: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ops_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, now)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare(`DELETE FROM ops_state WHERE key = ?`).bind(key).run();
  }
}
