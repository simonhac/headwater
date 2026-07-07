export interface WebhookEventRecord {
  id: string;
  received_at: number;
  source: string | null;
  raw_json: string;
  parsed_json: string | null;
  decision: string;
  reason: string | null;
  posted: number;
  slack_ts: string | null;
  error: string | null;
}

export interface AppendEventInput {
  id: string;
  receivedAt: number;
  source?: string | null;
  raw: string;
  parsed?: unknown;
  decision: "logged" | "posted" | "dropped" | "error";
  reason?: string | null;
  posted?: boolean;
  slackTs?: string | null;
  error?: string | null;
}

/** Append-only log of inbound webhook events; backs the /inspect page. */
export class EventLog {
  constructor(private db: D1Database) {}

  async append(e: AppendEventInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO webhook_events
           (id, received_at, source, raw_json, parsed_json, decision, reason, posted, slack_ts, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        e.id,
        e.receivedAt,
        e.source ?? null,
        e.raw,
        e.parsed === undefined ? null : JSON.stringify(e.parsed),
        e.decision,
        e.reason ?? null,
        e.posted ? 1 : 0,
        e.slackTs ?? null,
        e.error ?? null,
      )
      .run();
  }

  /** Update a previously-logged event row after processing (parse/filter/post). */
  async markProcessed(
    id: string,
    u: { parsed?: unknown; decision: string; reason?: string | null; posted?: boolean; slackTs?: string | null; error?: string | null; source?: string | null },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE webhook_events
            SET parsed_json = ?, decision = ?, reason = ?, posted = ?, slack_ts = ?, error = ?,
                source = COALESCE(?, source)
          WHERE id = ?`,
      )
      .bind(
        u.parsed === undefined ? null : JSON.stringify(u.parsed),
        u.decision,
        u.reason ?? null,
        u.posted ? 1 : 0,
        u.slackTs ?? null,
        u.error ?? null,
        u.source ?? null,
        id,
      )
      .run();
  }

  async recent(limit = 50): Promise<WebhookEventRecord[]> {
    const res = await this.db
      .prepare(`SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?`)
      .bind(limit)
      .all<WebhookEventRecord>();
    return res.results ?? [];
  }

  async get(id: string): Promise<WebhookEventRecord | null> {
    return await this.db
      .prepare(`SELECT * FROM webhook_events WHERE id = ?`)
      .bind(id)
      .first<WebhookEventRecord>();
  }

  /** Drop events older than the given epoch-ms cutoff (housekeeping). */
  async prune(olderThanMs: number): Promise<void> {
    await this.db.prepare(`DELETE FROM webhook_events WHERE received_at < ?`).bind(olderThanMs).run();
  }
}
