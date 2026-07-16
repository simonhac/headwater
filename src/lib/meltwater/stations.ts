/**
 * Broadcast station code → display name, backed by the D1 `station_names` table (seeded in
 * migrations/0007). The "Every Mention" webhook doesn't carry the station for radio/TV — `authorName`
 * is either the station or the reporter, and the real station name lives only on the broadcast viewer.
 * `src/lib/meltwater/station-resolve.ts` extracts the numeric code from the viewer token; this maps that
 * code to a name (from a station-like authorName, or from the StationRenderer DO). Adding a station is
 * now an INSERT.
 */

/** Station name for a Meltwater broadcast code, or null if not in the table. */
export async function stationNameForCode(db: D1Database, code: string | null | undefined): Promise<string | null> {
  if (!code) return null;
  const row = await db.prepare("SELECT name FROM station_names WHERE code = ?").bind(code).first<{ name: string }>();
  return row?.name ?? null;
}

/** Record a code→name mapping (idempotent). `attempts` is the render attempt it was resolved on (the
 * DO passes this); pass 0 for a render-free name taken from a station-like authorName; null = untracked. */
export async function upsertStationName(
  db: D1Database,
  code: string,
  name: string,
  now: number,
  attempts: number | null = null,
): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO station_names (code, name, resolved_at, attempts) VALUES (?, ?, ?, ?)")
    .bind(code, name, now, attempts)
    .run();
}

/** One row of the /stations status page — reconstructed from the codes we've actually seen. */
export interface StationResolution {
  code: string;
  name: string | null; // resolved name, or null if still unresolved
  first_sighting: number; // MIN(broadcast_stations.resolved_at) — when the code was first seen
  sightings: number; // distinct docs (clips) seen for this code
  resolved_at: number | null; // when named (null = seeded before timestamps, or still unresolved)
  attempts: number | null; // render attempts (null = untracked/historical, 0 = named render-free)
}

/**
 * Station-resolution status for every code we've seen, oldest first. Joins the code cache
 * (`broadcast_stations`) with the name map (`station_names`) and the pending queue (`render_queue`).
 * First-sighting and resolution time are reconstructed from existing rows; attempts are only known for
 * codes resolved/queued since attempt-tracking was added (null otherwise).
 */
export async function listStationResolutions(db: D1Database): Promise<StationResolution[]> {
  const rows = await db
    .prepare(
      `SELECT bs.code AS code,
              sn.name AS name,
              MIN(bs.resolved_at) AS first_sighting,
              COUNT(*) AS sightings,
              sn.resolved_at AS resolved_at,
              COALESCE(sn.attempts, rq.attempts) AS attempts
         FROM broadcast_stations bs
         LEFT JOIN station_names sn ON sn.code = bs.code
         LEFT JOIN render_queue  rq ON rq.code = bs.code
        WHERE bs.code IS NOT NULL
        GROUP BY bs.code
        ORDER BY first_sighting ASC`,
    )
    .all<StationResolution>();
  return rows.results;
}
