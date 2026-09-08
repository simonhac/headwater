/** Daily digest subscribers (migration 0012). One row per Slack user; managed by the `/digest` slash
 * command and read by the per-subscriber send in src/lib/digestSend.ts. */

export interface Subscriber {
  slack_user_id: string;
  email: string;
  /** IANA time zone, e.g. "Australia/Melbourne". */
  time_zone: string;
  /** Minutes after local midnight the digest goes out (multiple of 15). */
  send_minute: number;
  /** Send-once marker: the local calendar day (YYYY-MM-DD in time_zone) last sent, or null. */
  last_sent_day: string | null;
  created_at: number;
  updated_at: number;
}

export class SubscriberStore {
  constructor(private db: D1Database) {}

  async get(userId: string): Promise<Subscriber | null> {
    return this.db.prepare(`SELECT * FROM digest_subscribers WHERE slack_user_id = ?`).bind(userId).first<Subscriber>();
  }

  async all(): Promise<Subscriber[]> {
    const r = await this.db.prepare(`SELECT * FROM digest_subscribers ORDER BY created_at`).all<Subscriber>();
    return r.results;
  }

  async count(): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM digest_subscribers`).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Upsert. A re-subscribe refreshes email/zone/time and resets the send-once marker to the
   * caller's choice (see the subscribe handler for why it is sometimes "today"). */
  async upsert(
    sub: Pick<Subscriber, "slack_user_id" | "email" | "time_zone" | "send_minute" | "last_sent_day">,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO digest_subscribers (slack_user_id, email, time_zone, send_minute, last_sent_day, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slack_user_id) DO UPDATE SET
             email = excluded.email,
             time_zone = excluded.time_zone,
             send_minute = excluded.send_minute,
             last_sent_day = excluded.last_sent_day,
             updated_at = excluded.updated_at`,
      )
      .bind(sub.slack_user_id, sub.email, sub.time_zone, sub.send_minute, sub.last_sent_day, now, now)
      .run();
  }

  /** @returns true when a row was actually removed. */
  async remove(userId: string): Promise<boolean> {
    const r = await this.db.prepare(`DELETE FROM digest_subscribers WHERE slack_user_id = ?`).bind(userId).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async markSent(userId: string, day: string, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE digest_subscribers SET last_sent_day = ?, updated_at = ? WHERE slack_user_id = ?`)
      .bind(day, now, userId)
      .run();
  }
}
