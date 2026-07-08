import type { Env } from "@/env";
import { stationForCode } from "./stations";

/** Unwrap a Meltwater click-tracking URL to its underlying `u=` target. */
function unwrapU(t: unknown): string | null {
  if (typeof t !== "string") return null;
  try {
    const u = new URL(t).searchParams.get("u");
    return u ? decodeURIComponent(u) : t;
  } catch {
    return null;
  }
}

/** Meltwater document id from a `.../paywall/redirect/<docId>` transition link. */
export function docIdFromLinks(links: unknown): string | null {
  const l = links as { article?: unknown; source?: unknown } | null;
  const art = unwrapU(l?.article) ?? unwrapU(l?.source);
  const m = art?.match(/\/paywall\/redirect\/([^/?]+)/);
  return m ? m[1]! : null;
}

/** Fetch the transition link and read `Station=<code>` from the mediaView redirect it serves. */
async function fetchStationCode(transitionUrl: string): Promise<string | null> {
  try {
    const res = await fetch(transitionUrl, { signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    const m = html.match(/https:\/\/broadcast\.meltwater\.com\/mediaView\/\?[A-Za-z0-9%._-]+/);
    if (!m) return null;
    const token = new URL(m[0]).search.replace(/^\?/, "").split("&")[0]!;
    const decoded = atob(decodeURIComponent(token)); // Station=<code>&StartDateTime=...
    return decoded.match(/Station=([^&]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a broadcast item's station name, caching the code in D1 by Meltwater docId so each
 * article is fetched at most once (replays hit the cache). The code→name lookup is the static
 * STATION_BY_CODE map, so seeding a name there later fixes cached rows without a re-fetch.
 */
export async function resolveStationName(env: Env, raw: unknown): Promise<string | null> {
  const links = (raw as { links?: unknown } | null)?.links;
  const docId = docIdFromLinks(links);
  if (!docId) return null;

  const cached = await env.DB.prepare("SELECT code FROM broadcast_stations WHERE doc_id = ?")
    .bind(docId)
    .first<{ code: string | null }>();
  if (cached) return stationForCode(cached.code);

  const transition = unwrapU((links as { article?: unknown; source?: unknown } | null)?.article) ??
    unwrapU((links as { source?: unknown } | null)?.source);
  const code = transition ? await fetchStationCode(transition) : null;
  await env.DB.prepare("INSERT OR REPLACE INTO broadcast_stations (doc_id, code, resolved_at) VALUES (?, ?, ?)")
    .bind(docId, code, Date.now())
    .run();
  return stationForCode(code);
}
