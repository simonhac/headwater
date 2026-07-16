import type { Env } from "@/env";
import { parseWebhookPayload, isBroadcastMedium } from "@/lib/meltwater/parse";
import { docIdFromLinks, viewerUrlForRaw } from "@/lib/meltwater/station-resolve";
import { upsertStationName } from "@/lib/meltwater/stations";
import { looksLikePerson } from "@/lib/meltwater/outlets";
import { enqueueStationRender } from "@/do/client";

export interface BackfillResult {
  events: number; // archived events scanned
  broadcast: number; // broadcast mentions seen
  known: number; // codes already named (nothing to do)
  seeded: number; // codes named from a station-like authorName (render-free)
  enqueued: number; // codes queued for the serial renderer (presenter authorName, unknown station)
  noCode: number; // broadcast mentions whose code isn't in the cache (skipped; never re-fetched here)
}

/**
 * One-time warm start: re-scan the archived webhooks and, for every broadcast mention whose station
 * code isn't named yet, either seed `station_names` from a station-like `authorName` (render-free) or
 * enqueue it for the StationRenderer DO. This front-loads the D1 map so most stations are named up
 * front; the hourly redecode then upgrades their already-posted cards.
 *
 * Cheap by construction: it preloads the docId→code cache and the named-code set in TWO queries, then
 * does everything else in memory — so the only per-request subrequests are the handful of writes for
 * still-unnamed codes. (The first version did a D1 read + possible fetch PER event, which blew the
 * Worker subrequest/time budget → 502.) Idempotent and re-runnable (dedup by code). Newest-first,
 * capped by `limit`.
 */
export async function backfillStations(env: Env, opts: { limit: number }): Promise<BackfillResult> {
  const res: BackfillResult = { events: 0, broadcast: 0, known: 0, seeded: 0, enqueued: 0, noCode: 0 };
  const now = Date.now();

  // Preload docId→code + each code's first-sighting (so a render-free name is stamped with WHEN it was
  // first resolvable, a faithful historical resolution time on /stations).
  const codeByDoc = new Map<string, string | null>();
  const firstSeen = new Map<string, number>();
  for (const r of (
    await env.DB.prepare("SELECT doc_id, code, resolved_at FROM broadcast_stations").all<{
      doc_id: string;
      code: string | null;
      resolved_at: number;
    }>()
  ).results) {
    codeByDoc.set(r.doc_id, r.code);
    if (r.code != null) {
      const prev = firstSeen.get(r.code);
      if (prev == null || r.resolved_at < prev) firstSeen.set(r.code, r.resolved_at);
    }
  }
  // Codes already named — mutated as we seed, so a code seeded earlier in this run isn't re-handled.
  const named = new Set<string>(
    (await env.DB.prepare("SELECT code FROM station_names").all<{ code: string }>()).results.map((r) => r.code),
  );

  const rows = (
    await env.DB.prepare(
      "SELECT raw_json FROM webhook_events WHERE json_valid(raw_json) ORDER BY received_at DESC LIMIT ?",
    )
      .bind(opts.limit)
      .all<{ raw_json: string }>()
  ).results;

  const handled = new Set<string>();
  for (const row of rows) {
    res.events++;
    let payload: unknown;
    try {
      payload = JSON.parse(row.raw_json);
    } catch {
      continue;
    }
    for (const m of parseWebhookPayload(payload)) {
      if (!isBroadcastMedium(m.mediaType)) continue;
      res.broadcast++;
      const docId = docIdFromLinks((m.raw as { links?: unknown } | null)?.links);
      const code = docId ? (codeByDoc.get(docId) ?? null) : null;
      if (!code) {
        res.noCode++;
        continue;
      }
      if (handled.has(code)) continue;
      if (named.has(code)) {
        res.known++;
        handled.add(code);
        continue;
      }
      const header = m.sourceName?.trim() || null;
      if (header && !looksLikePerson(header)) {
        await upsertStationName(env.DB, code, header, firstSeen.get(code) ?? now, 0); // resolvable since first seen
        named.add(code);
        res.seeded++;
        handled.add(code);
        continue;
      }
      const url = viewerUrlForRaw(m.raw);
      if (url) {
        await enqueueStationRender(env, code, url);
        res.enqueued++;
        handled.add(code);
      }
    }
  }
  return res;
}
