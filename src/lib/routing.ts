/**
 * Brief → Slack channel routing. Many-to-many: one brief fans out to N channels, and a channel can
 * carry many briefs.
 *
 * Routing lives in D1 (`ops_state` key `routing`), NOT in `feed.config.ts`, for two reasons: it's
 * edited from `/inspect/routing` without a redeploy, and channel ids are treated like
 * `SLACK_DEFAULT_CHANNEL` (a secret) so they never land in this public repo.
 *
 * A brief with no entry — or an entry that is empty after validation — falls back to
 * `SLACK_DEFAULT_CHANNEL`, so an empty `routing` reproduces the pre-fanout behaviour exactly.
 */
import type { Env } from "@/env";
import { OpsState } from "@/lib/store/opsState";

export const ROUTING_KEY = "routing";

export interface Routing {
  v: 1;
  /** briefId → channel ids. The unmatched/synthesized brief is routable under the id `default`. */
  briefs: Record<string, string[]>;
  /** Epoch ms of the last save (0 when never saved). */
  updatedAt: number;
}

export function emptyRouting(): Routing {
  return { v: 1, briefs: {}, updatedAt: 0 };
}

/** Drop blanks and duplicates while preserving order. */
function clean(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Read the saved routing. Never throws: a missing or corrupt value degrades to "route everything
 * to the default channel", which is the safe direction (we'd rather over-post to the known channel
 * than silently stop posting). */
export async function loadRouting(db: D1Database): Promise<Routing> {
  const raw = await new OpsState(db).get(ROUTING_KEY);
  if (!raw) return emptyRouting();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyRouting();
    const o = parsed as { briefs?: unknown; updatedAt?: unknown };
    const briefs: Record<string, string[]> = {};
    if (o.briefs && typeof o.briefs === "object") {
      for (const [id, chans] of Object.entries(o.briefs as Record<string, unknown>)) {
        if (Array.isArray(chans)) briefs[id] = clean(chans as string[]);
      }
    }
    return { v: 1, briefs, updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0 };
  } catch {
    return emptyRouting();
  }
}

export async function saveRouting(db: D1Database, routing: Routing, now: number): Promise<void> {
  const next: Routing = { v: 1, briefs: routing.briefs, updatedAt: now };
  await new OpsState(db).set(ROUTING_KEY, JSON.stringify(next), now);
}

/** The channels a brief posts to: its routed list, or the default channel when it has none. */
export function channelsFor(briefId: string, routing: Routing, env: Env): string[] {
  const routed = clean(routing.briefs[briefId] ?? []);
  if (routed.length) return routed;
  return clean([env.SLACK_DEFAULT_CHANNEL ?? ""]);
}

/** Every channel the Worker may have posted into — default first, then every routed channel.
 * Backs the orphan sweep and the replay purge, which must scan/clean each of them. */
export function configuredChannels(routing: Routing, env: Env): string[] {
  return clean([env.SLACK_DEFAULT_CHANNEL ?? "", ...Object.values(routing.briefs).flat()]);
}

/**
 * Build a Routing from a parsed `/inspect/routing` form body. Checkboxes are named `r.<briefId>`
 * with the channel id as the value, so Hono's `parseBody({ all: true })` yields a string for a
 * single tick and an array for several. Unknown brief ids and channel ids not in the live Slack
 * list are dropped, so a stale open tab can't write junk (or a channel the bot has since left).
 * `updatedAt` is stamped by `saveRouting`.
 */
export function parseRoutingForm(
  body: Record<string, unknown>,
  briefIds: readonly string[],
  allowedChannelIds: readonly string[],
): Routing {
  const briefs: Record<string, string[]> = {};
  for (const id of briefIds) {
    const raw = body[`r.${id}`];
    const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const chans = clean(values.filter((v): v is string => typeof v === "string")).filter((c) =>
      allowedChannelIds.includes(c),
    );
    if (chans.length) briefs[id] = chans;
  }
  return { v: 1, briefs, updatedAt: 0 };
}
