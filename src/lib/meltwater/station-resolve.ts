import type { Env } from "@/env";
import type { Page } from "@cloudflare/puppeteer";
import puppeteer from "@cloudflare/puppeteer";
import { stationNameForCode } from "./stations";

type Links = { article?: unknown; source?: unknown } | null | undefined;

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

/** The best link to follow to the broadcast viewer (article first, then source), unwrapped. */
function viewerUrl(links: Links): string | null {
  return unwrapU(links?.article) ?? unwrapU(links?.source);
}

/** The unwrapped viewer/transition URL to render for a raw webhook doc — what the drainer enqueues. */
export function viewerUrlForRaw(raw: unknown): string | null {
  return viewerUrl((raw as { links?: unknown } | null)?.links as Links);
}

/** Meltwater document id from a `.../paywall/redirect/<docId>` transition link. */
export function docIdFromLinks(links: unknown): string | null {
  const l = links as Links;
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

/** Resolve the Meltwater numeric broadcast code for an item (cached in D1 by docId; fetched on miss).
 * Browser-free — used by ingestion (authorName-trust / cache), the redecode backfill, and enqueue. */
export async function stationCodeFor(env: Env, raw: unknown): Promise<{ docId: string; code: string | null } | null> {
  const links = (raw as { links?: unknown } | null)?.links as Links;
  const docId = docIdFromLinks(links);
  if (!docId) return null;

  const cached = await env.DB.prepare("SELECT code FROM broadcast_stations WHERE doc_id = ?")
    .bind(docId)
    .first<{ code: string | null }>();
  if (cached) return { docId, code: cached.code };

  const transition = viewerUrl(links);
  const code = transition ? await fetchStationCode(transition) : null;
  await env.DB.prepare("INSERT OR REPLACE INTO broadcast_stations (doc_id, code, resolved_at) VALUES (?, ?, ?)")
    .bind(docId, code, Date.now())
    .run();
  return { docId, code };
}

/**
 * Station name from the D1 `station_names` map only (no browser) — the numeric code is cached in D1 by
 * docId, so this is cheap and safe to call from the ingestion path and the redecode backfill. Returns
 * null for an unknown code (which the caller resolves via authorName-trust or the deferred renderer).
 */
export async function resolveStationName(env: Env, raw: unknown): Promise<string | null> {
  const c = await stationCodeFor(env, raw);
  return c ? stationNameForCode(env.DB, c.code) : null;
}

/** Station name from a rendered viewer title — "702 ABC Sydney - <program> - <time>" → "702 ABC
 * Sydney". Null for the pre-load placeholder or an unparseable title. */
export function stationNameFromTitle(title: string | null): string | null {
  const name = title?.split(" - ")[0]?.trim() ?? "";
  return name && name !== "Broadcast player" ? name : null;
}

/**
 * Navigate an ALREADY-OPEN page to a Meltwater viewer URL and return its settled title. The viewer is
 * a client-rendered SPA that redirects transition → mediaView → segment and only sets a
 * "<Station> - <program> - <time>" title after a further in-SPA hop, so we wait on the title PATTERN
 * (two " - " separators) rather than a fixed delay — the old fixed ~9.6s poll returned before that
 * last hop under a cold headless browser. Best-effort: returns whatever title is present if the wait
 * times out. Exported so the serial renderer (StationRenderer DO) can reuse one warm browser across
 * many URLs instead of launching one per URL.
 */
export async function renderTitleOnPage(page: Page, url: string): Promise<string | null> {
  await page.goto(url, { waitUntil: "load", timeout: 15000 });
  // A string expression (not a closure) so it evaluates in the PAGE context — `document` is the
  // browser's, not the Worker's (which has no DOM). Waits for "<Station> - <program> - <time>". A
  // resolvable viewer settles in ~1-2s, so a 10s cap keeps a FAILED render cheap (it counts against
  // the daily browser-time budget) without cutting off a slow-but-valid one.
  await page
    .waitForFunction(
      "!!document.title && document.title !== 'Broadcast player' && / - .+ - /.test(document.title)",
      { timeout: 10000, polling: 250 },
    )
    .catch(() => {}); // timed out → fall through and read whatever title is set
  return (await page.title().catch(() => "")) || null;
}

/**
 * Single-shot render: launch ONE browser, render a viewer URL, disconnect. Used by the
 * `/admin/render-station` verify endpoint. Ingestion never renders inline anymore (the StationRenderer
 * DO owns all rendering, serially, on a reused browser). Null on a missing binding or any failure.
 */
export async function renderViewerTitle(env: Env, url: string): Promise<string | null> {
  if (!env.BROWSER) return null; // no Browser Rendering binding (e.g. tests) → skip
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    return await renderTitleOnPage(page, url);
  } catch {
    return null;
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
  }
}
