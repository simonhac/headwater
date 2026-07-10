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
  decision: "logged" | "posted" | "dropped" | "duplicate" | "merged" | "preview" | "error";
  reason?: string | null;
  posted?: boolean;
  slackTs?: string | null;
  error?: string | null;
}

/**
 * SQL predicate (over a `webhook_events` row) for "failed / undelivered": the event errored, or its
 * parsed summary still records an un-delivered kept mention (`$.failed > 0` — a Slack post/update
 * that failed, incl. a partial failure). The `$.failed` half drains as the reconcile re-delivers.
 * Constant, not user input — safe to interpolate. Shared by `failures`/`failuresCount` so the
 * /inspect list and its badge stay in lockstep.
 */
const FAILED_PREDICATE = "(decision = 'error' OR json_extract(parsed_json, '$.failed') > 0)";

/** Append-only log of inbound webhook events; backs the /inspect page. */
export class EventLog {
  constructor(private db: D1Database) {}

  async append(e: AppendEventInput): Promise<void> {
    // OR IGNORE so an ingestion retry (same `id`) after a partial commit is a no-op, not a
    // PRIMARY KEY collision that would look like a hard failure. See src/index.ts append retry.
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_events
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

  /**
   * Update a previously-logged event row after processing (parse/filter/post).
   *
   * **Monotonic / non-destructive.** The reconcile cron (and a non-reset `/admin/replay`) re-runs
   * `processEvent` over already-delivered events; every mention is then `seen` → all "duplicate", so
   * the fresh summary is `posted=0`/`decision='duplicate'` with no `slack_ts`. Writing that verbatim
   * would *downgrade* a healthy `posted/merged` row (breaking the `limit` replay's `WHERE posted=1`
   * and, crucially, repainting the /inspect card grey since it renders from `parsed_json`). So we:
   *   - keep `parsed_json`/`decision` when the row is already `posted`/`merged` and the new outcome
   *     isn't (a genuine heal — new decision `posted`/`merged` — still upgrades and refreshes both),
   *   - never lower `posted` (MAX), and keep the original `slack_ts` (COALESCE).
   */
  async markProcessed(
    id: string,
    u: { parsed?: unknown; decision: string; reason?: string | null; posted?: boolean; slackTs?: string | null; error?: string | null; source?: string | null },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE webhook_events
            SET parsed_json = CASE WHEN ?1 IN ('posted','merged') THEN ?2
                                   WHEN decision IN ('posted','merged') THEN parsed_json
                                   ELSE ?2 END,
                decision    = CASE WHEN ?1 IN ('posted','merged') THEN ?1
                                   WHEN decision IN ('posted','merged') THEN decision
                                   ELSE ?1 END,
                reason      = ?3,
                posted      = MAX(posted, ?4),
                slack_ts    = COALESCE(?5, slack_ts),
                error       = ?6,
                source      = COALESCE(?7, source)
          WHERE id = ?8`,
      )
      .bind(
        u.decision,
        u.parsed === undefined ? null : JSON.stringify(u.parsed),
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

  /**
   * A page of events newest-first, optionally older than `beforeMs` (exclusive) — the
   * cursor used by the /inspect "older messages" pager. Pass null for the latest page.
   */
  async page(beforeMs: number | null, limit = 50): Promise<WebhookEventRecord[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM webhook_events
          WHERE (?1 IS NULL OR received_at < ?1)
          ORDER BY received_at DESC
          LIMIT ?2`,
      )
      .bind(beforeMs, limit)
      .all<WebhookEventRecord>();
    return res.results ?? [];
  }

  /** Epoch-ms of the most recent inbound webhook that parsed into a real mention (its `source`
   *  is populated only once the pipeline processes a mention). Backs the heartbeat: unlike a raw
   *  MAX(received_at) this ignores non-mention POSTs — empty-body probes, health pings, malformed
   *  bodies — so they can't reset the ingestion-stall clock and mask a genuine upstream outage. */
  async latestMentionReceivedAt(): Promise<number | null> {
    const row = await this.db
      .prepare(`SELECT MAX(received_at) AS m FROM webhook_events WHERE source IS NOT NULL`)
      .first<{ m: number | null }>();
    return row?.m ?? null;
  }

  /**
   * A page of *failed / undelivered* events newest-first, received since `sinceMs` — events that
   * errored, or whose parsed summary shows an un-delivered kept mention (`$.failed > 0`, which
   * includes a *partial* failure where the headline posted but a syndicated outlet's update failed).
   * Backs the /inspect `?filter=failed` view. Windowed to match the drift badge (`failuresCount`)
   * so the two never disagree. Cursor (`beforeMs`) semantics match `page`.
   */
  async failures(sinceMs: number, beforeMs: number | null, limit = 50): Promise<WebhookEventRecord[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM webhook_events
          WHERE ${FAILED_PREDICATE}
            AND received_at >= ?1
            AND (?2 IS NULL OR received_at < ?2)
          ORDER BY received_at DESC
          LIMIT ?3`,
      )
      .bind(sinceMs, beforeMs, limit)
      .all<WebhookEventRecord>();
    return res.results ?? [];
  }

  /** Count of the `failures` set since `sinceMs` — drives the /inspect "N failed" badge. */
  async failuresCount(sinceMs: number): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM webhook_events WHERE ${FAILED_PREDICATE} AND received_at >= ?`)
      .bind(sinceMs)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Drift gauges for /health, over events received since `sinceMs`:
   *   - `errors`   — `decision='error'`: a parse failure at ingest, a processing throw, or a Slack
   *                  failure that delivered nothing. Slack failures self-heal on the next reconcile;
   *                  un-parseable payloads can't be reprocessed and instead age out of the window.
   *   - `unposted` — events whose parsed summary still shows an un-delivered kept mention
   *                  (`$.failed > 0`) — the reconcile-healable drift, including partial failures.
   *                  Excludes healthy terminals (posted/merged/duplicate/dropped/preview) AND benign
   *                  zero-mention payloads. A value that doesn't drain across ticks means real drift.
   */
  async driftCounts(sinceMs: number): Promise<{ errors: number; unposted: number }> {
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN decision = 'error' THEN 1 ELSE 0 END), 0) AS errors,
           COALESCE(SUM(CASE WHEN json_extract(parsed_json, '$.failed') > 0 THEN 1 ELSE 0 END), 0) AS unposted
         FROM webhook_events
         WHERE received_at >= ?`,
      )
      .bind(sinceMs)
      .first<{ errors: number; unposted: number }>();
    return { errors: row?.errors ?? 0, unposted: row?.unposted ?? 0 };
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
